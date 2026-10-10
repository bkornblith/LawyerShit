import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import JSZip from "jszip";
import { cleanSuggestions } from "./suggestions";
import type { FillResult, FormField, FormMeta } from "./types";

// Asks Claude to fill a form from the attorney's notes and the client's
// documents. Nothing here is stored: the documents go to the Claude API for
// this one request and the suggested values come back to the browser.

export const MODEL = "claude-haiku-5-5";

export class FillError extends Error {}

export type ContextFile = { name: string; type: string; data: Buffer };

const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
const TEXT_EXT = /\.(txt|md|csv|json|eml)$/i;

export function aiConfigured(): boolean {
  return !!process.env.ANTHROPIC_API_KEY;
}

async function docxText(data: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(data);
  const xml = await zip.file("word/document.xml")?.async("string");
  if (!xml) throw new FillError("A Word file couldn't be read.");
  return xml
    .replace(/<w:tab\/>/g, "\t")
    .replace(/<\/w:p>/g, "\n")
    .replace(/<w:br[^>]*\/>/g, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function fileBlock(f: ContextFile): Promise<Anthropic.ContentBlockParam> {
  const title = f.name.slice(0, 200);
  if (f.type === "application/pdf" || /\.pdf$/i.test(f.name)) {
    return {
      type: "document",
      title,
      source: { type: "base64", media_type: "application/pdf", data: f.data.toString("base64") },
    };
  }
  if (IMAGE_TYPES.has(f.type)) {
    return {
      type: "image",
      source: { type: "base64", media_type: f.type as "image/jpeg", data: f.data.toString("base64") },
    };
  }
  if (/\.docx$/i.test(f.name)) {
    return { type: "document", title, source: { type: "text", media_type: "text/plain", data: await docxText(f.data) } };
  }
  if (f.type.startsWith("text/") || TEXT_EXT.test(f.name)) {
    return { type: "document", title, source: { type: "text", media_type: "text/plain", data: f.data.toString("utf8") } };
  }
  throw new FillError(`"${f.name}" isn't a supported file type. Use PDF, Word (.docx), images or text files.`);
}

function describeField(f: FormField): string {
  let kind: string = f.kind;
  if (f.kind === "text") {
    const bits = [f.multiline ? "multi-line text" : "text"];
    if (f.maxLength) bits.push(`max ${f.maxLength} characters`);
    kind = bits.join(", ");
  } else if (f.options?.length) {
    kind = `${f.kind}, one of: ${f.options.join(" / ")}`;
  }
  return `${f.key} | page ${f.page || "?"} | ${kind} | ${f.label}`;
}

const SYSTEM = `You are an experienced immigration paralegal at Davis & Kwong LLP, a small law firm. You fill in government and court forms for the firm's attorneys from the information they give you about a client. An attorney reviews every field you fill before anything is filed.

How to fill the form:
- Use only information that the attorney's notes or the client's documents actually support. Never guess or invent a name, date, number or address. A wrong answer on a filed form is far worse than a blank one.
- Leave a field out entirely when the information isn't there. Don't write "N/A", "None" or "Unknown" unless the attorney's notes or the form's own instructions in the materials call for it.
- Read the blank form itself to understand who each part is about (for example, petitioner versus beneficiary, or the person filing versus the person the petition is for) and which parts apply given the client's situation. Skip parts that don't apply.
- Checkboxes: return the value "checked" only for boxes that should be ticked. For yes/no pairs and lists of choices, tick only the one that applies.
- Dropdowns and radio buttons: the value must be exactly one of the listed choices.
- Respect the maximum length of a field. Use the form's conventions: dates as MM/DD/YYYY, A-Numbers as digits only (the form prints the "A"), phone numbers as digits only, and names exactly as on the client's identity documents.
- Leave signature fields and the dates of signature blank. The attorney fills in the preparer and attorney sections unless their details are in the notes.
- For each field you fill, give a short basis: where the value came from (e.g. "passport", "attorney notes", "birth certificate (translated)").
- In "missing", list the important information the form asks for that you couldn't find, in plain words an attorney can act on (e.g. "Beneficiary's date of last arrival in the U.S."). Keep it to what matters.
- In "notes", flag anything the attorney should double-check: conflicting information between documents, spelling differences, judgment calls you made. Keep it brief; write an empty string if there is nothing to flag.`;

const OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["fields", "missing", "notes"],
  properties: {
    fields: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["key", "value", "basis"],
        properties: {
          key: { type: "string", description: "The field key, e.g. f12" },
          value: { type: "string" },
          basis: { type: "string" },
        },
      },
    },
    missing: { type: "array", items: { type: "string" } },
    notes: { type: "string" },
  },
} as const;

export async function suggestValues(opts: {
  form: FormMeta;
  template: Buffer;
  notes: string;
  files: ContextFile[];
  preparedBy: string;
}): Promise<FillResult> {
  const { form, template, notes, files, preparedBy } = opts;
  if (!aiConfigured()) throw new FillError("Automatic filling isn't set up yet: add ANTHROPIC_API_KEY in Vercel.");

  const fieldList = form.fields.map(describeField).join("\n");
  const fileBlocks = await Promise.all(files.map(fileBlock));
  const fileNames = files.length ? files.map((f) => `- ${f.name}`).join("\n") : "(none)";

  const client = new Anthropic();
  const stream = client.messages.stream({
    model: MODEL,
    max_tokens: 64000,
    output_config: { effort: "high", format: { type: "json_schema", schema: OUTPUT_SCHEMA } },
    system: SYSTEM,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "document",
            title: `Blank form: ${form.name}`,
            source: { type: "base64", media_type: "application/pdf", data: template.toString("base64") },
          },
          {
            type: "text",
            text:
              `Above is the blank form "${form.name}"${form.description ? ` (${form.description})` : ""}.\n\n` +
              `Its fillable fields, one per line as "key | page | type | description":\n${fieldList}` +
              (form.instructions.trim() ? `\n\nThe firm's standing instructions for this form:\n${form.instructions.trim()}` : ""),
            // The form and its field list are the same on every fill of this form.
            cache_control: { type: "ephemeral" },
          },
          ...fileBlocks,
          {
            type: "text",
            text:
              `Prepared by: ${preparedBy}, Davis & Kwong LLP.\n\n` +
              `Client documents attached:\n${fileNames}\n\n` +
              `Attorney's notes about the client:\n${notes.trim() || "(none)"}\n\n` +
              `Fill in the form for this client.`,
          },
        ],
      },
    ],
  });

  let message: Anthropic.Message;
  try {
    message = await stream.finalMessage();
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) throw new FillError("The Claude API key isn't valid. Check ANTHROPIC_API_KEY in Vercel.");
    if (e instanceof Anthropic.RateLimitError) throw new FillError("Claude is busy right now. Try again in a minute.");
    if (e instanceof Anthropic.BadRequestError) throw new FillError(`Claude couldn't read the request: ${e.message}`);
    if (e instanceof Anthropic.APIError) throw new FillError(`Claude returned an error (${e.status ?? "network"}). Try again.`);
    throw e;
  }

  if (message.stop_reason === "refusal") throw new FillError("Claude declined to fill this form. Fill it in by hand below.");
  if (message.stop_reason === "max_tokens") throw new FillError("The answer was too long to finish. Try again with fewer documents.");
  const text = message.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
  let parsed: { fields: { key: string; value: string; basis: string }[]; missing: string[]; notes: string };
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new FillError("Claude's answer couldn't be read. Try again.");
  }
  return {
    values: cleanSuggestions(form.fields, parsed.fields ?? []),
    missing: (parsed.missing ?? []).filter((m) => typeof m === "string" && m.trim()),
    notes: typeof parsed.notes === "string" ? parsed.notes.trim() : "",
  };
}
