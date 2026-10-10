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
];
