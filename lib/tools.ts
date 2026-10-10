// The tools shown on the dashboard. Add a new tool by adding an entry here and
// a page under app/tools/<slug>/.
export type Tool = { slug: string; name: string; description: string; ready: boolean };

export const TOOLS: Tool[] = [
  {
    slug: "redact",
    name: "Redact client information",
    description:
      "Upload a PDF or Word file, enter the client's details, and get back a copy with the client's name, date of birth, A-number, address and signature permanently blacked out.",
    ready: true,
  },
  {
    slug: "forms",
    name: "Fill a form",
    description:
      "Keep a library of blank forms such as USCIS petitions. Pick one, add the client's details and documents, and Claude fills it in for you to check and download.",
    ready: true,
  },
];
