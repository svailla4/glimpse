// Decision views-are-blueprints: the plugin's skill is one core file that routes to a guide per task, and a command
// per guide. These check the files agree with each other and with the catalog; skill.test.ts in the server package
// shows every worked example.
import {describe, expect, it} from 'vitest';
import {EXAMPLES, GUIDES, READER_PROMPT, SKILL_DESCRIPTION, pluginFiles, serverInstructions, skillMarkdown} from '../src/index.ts';

const files = pluginFiles();
const skill = skillMarkdown();

describe('the plugin skill', () => {
  it('has the front matter Claude Code reads, with a description that says when, within the 1,024 characters allowed', () => {
    expect(skill.startsWith(`---\nname: glimpse\ndescription: ${SKILL_DESCRIPTION}\n---\n`)).toBe(true);
    expect(SKILL_DESCRIPTION.length).toBeLessThanOrEqual(1024);
    for (const task of ['design', 'plan', 'review', 'explain', 'pull request']) expect(SKILL_DESCRIPTION).toContain(task);
  });

  it('is one core file, under the 500 lines a skill should stay within, with the spec reference and the reader check', () => {
    expect(skill.split('\n').length).toBeLessThan(500);
    expect(skill).toContain(serverInstructions());
    for (const line of READER_PROMPT.split('\n')) expect(skill).toContain(`   > ${line}`);
  });

  it('routes each task to its guide, and every guide it names is generated', () => {
    const named = [...skill.matchAll(/`references\/([a-z]+)\.md`/g)].map(m => m[1]);
    expect(new Set(named)).toEqual(new Set(GUIDES.map(g => g.name)));
    for (const guide of GUIDES) expect(files[`skills/glimpse/references/${guide.name}.md`], guide.name).toBeDefined();
  });

  it('prints each worked example once: a guide example in its guide only, a quick recipe in SKILL.md only', () => {
    for (const example of EXAMPLES) {
      const homes = Object.entries(files).filter(([, text]) => text.includes(example.spec!)).map(([path]) => path);
      expect(homes, example.title).toEqual([example.guide ? `skills/glimpse/references/${example.guide}.md` : 'skills/glimpse/SKILL.md']);
    }
  });

  it('gives every guide a command that loads the skill with that guide and passes the arguments on', () => {
    for (const guide of GUIDES) {
      const command = files[`commands/${guide.name}.md`]!;
      expect(command).toMatch(/^---\ndescription: .+\nargument-hint: .+\n---\n/);
      expect(command).toContain(`references/${guide.name}.md`);
      expect(command).toContain('$ARGUMENTS');
      expect(command).toContain('reader check');
    }
  });

  it('names no local path in any file', () => {
    for (const [path, text] of Object.entries(files)) expect(text, path).not.toMatch(/\/Users\/|\/home\//);
  });
});
