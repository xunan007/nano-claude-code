import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

import type { SkillDocument, SkillManifest } from "./types";

export class SkillRegistry {
    private readonly documents: Map<string, SkillDocument> = new Map();

    constructor(private readonly skillsDir: string) {
        this.loadAll();
    }

    describeAvailable(): string {
        if (this.documents.size === 0) {
            return "(no skills available)";
        }

        return [...this.documents.keys()]
            .sort()
            .map((name) => {
                const document = this.documents.get(name);
                if (!document) {
                    return "";
                }
                return `- ${document.manifest.name}: ${document.manifest.description}`;
            })
            .filter(Boolean)
            .join("\n");
    }

    loadFullText(name: string): string {
        const document = this.documents.get(name);
        if (!document) {
            const known = [...this.documents.keys()].sort().join(", ");
            return `Error: Unknown skill '${name}'. Available skills: ${
                known || "(none)"
            }`;
        }

        return `<skill name="${document.manifest.name}">\n${document.body}\n</skill>`;
    }

    private loadAll(): void {
        if (!existsSync(this.skillsDir)) {
            return;
        }

        for (const path of this.findSkillFiles(this.skillsDir)) {
            const { metadata, body } = this.parseFrontmatter(
                readFileSync(path, "utf8"),
            );
            const fallbackName = dirname(path).split(/[\\/]/).at(-1);
            const name = metadata.name || fallbackName || "skill";
            const description = metadata.description || "No description";
            const manifest: SkillManifest = {
                name,
                description,
                path,
            };
            this.documents.set(name, {
                manifest,
                body: body.trim(),
            });
        }
    }

    private findSkillFiles(dir: string): string[] {
        const entries = readdirSync(dir)
            .map((entry) => join(dir, entry))
            .sort();
        const paths: string[] = [];

        for (const entry of entries) {
            const stat = statSync(entry);
            if (stat.isDirectory()) {
                paths.push(...this.findSkillFiles(entry));
            } else if (stat.isFile() && entry.endsWith("SKILL.md")) {
                paths.push(entry);
            }
        }

        return paths;
    }

    private parseFrontmatter(text: string): {
        metadata: Record<string, string>;
        body: string;
    } {
        const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)/.exec(text);
        if (!match) {
            return { metadata: {}, body: text };
        }

        const metadata: Record<string, string> = {};
        const frontmatter = match[1] ?? "";
        const body = match[2] ?? "";
        for (const line of frontmatter.trim().split(/\r?\n/)) {
            const separatorIndex = line.indexOf(":");
            if (separatorIndex === -1) {
                continue;
            }
            const key = line.slice(0, separatorIndex).trim();
            const value = line.slice(separatorIndex + 1).trim();
            if (key) {
                metadata[key] = value;
            }
        }

        return { metadata, body };
    }
}
