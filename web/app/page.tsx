import { readFileSync } from "node:fs";
import path from "node:path";
import { AccordApp, type Samples } from "../src/ui/AccordApp";

// The checked-in canonical fixtures, read once at build time. The browser still imports them
// through the same parse and validation path as a user's files.
const fixture = (name: string) => ({ name, text: readFileSync(path.join(process.cwd(), "..", "fixtures", "inventory", name), "utf8") });
const samples: Samples = { A: fixture("source-a.csv"), B: fixture("source-b.csv") };

export default function Home() {
  return <AccordApp samples={samples} />;
}
