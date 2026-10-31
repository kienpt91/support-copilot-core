// Copies non-TypeScript runtime assets (the embeddable widget) next to the compiled output.
import { cpSync, mkdirSync } from "node:fs";

mkdirSync("dist/widget", { recursive: true });
cpSync("src/widget/widget.js", "dist/widget/widget.js");
