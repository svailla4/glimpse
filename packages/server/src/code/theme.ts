// packages/server/src/code/theme.ts
// A TextMate theme that carries no colours, only classes: each rule's foreground is a sentinel #00000N, where N is
// the index into TOKEN_CLASSES ('', kw, str, fn, type, num, const, com). The highlighter maps the colour of every
// token back to N; the viewer colours the classes with CSS, so a theme switch never re-tokenises.
import type {TokenClass} from '@glimpse/catalog';
import type {ThemeRegistration} from 'shiki/core';

export const THEME_NAME = 'glimpse-classes';

const PLAIN = 0;
const KEYWORD = 1;
const STRING = 2;
const FUNCTION = 3;
const TYPE = 4;
const NUMBER = 5;
const CONSTANT = 6;
const COMMENT = 7;

const sentinel = (cls: TokenClass): string => `#00000${cls}`;
const rule = (cls: TokenClass, scope: string[]) => ({scope, settings: {foreground: sentinel(cls)}});

// The most specific scope wins, so a later, narrower rule refines an earlier, broader one (operators are plain
// although they are `keyword.*`; word operators such as `typeof` are keywords again).
export const glimpseTheme: ThemeRegistration = {
  name: THEME_NAME,
  type: 'light',
  colors: {'editor.foreground': sentinel(PLAIN), 'editor.background': '#ffffff'},
  tokenColors: [
    rule(KEYWORD, [
      'keyword', 'storage', 'storage.type', 'storage.modifier',
      'entity.name.tag', 'markup.heading', 'entity.name.section', 'punctuation.definition.list.begin.markdown',
      'meta.diff.range', 'punctuation.definition.range.diff',
    ]),
    rule(PLAIN, [
      'keyword.operator', 'keyword.control.ternary', 'storage.type.function.arrow', 'storage.modifier.import', 'storage.modifier.package',
      'storage.modifier.reference', 'storage.modifier.pointer', 'meta.embedded', 'meta.template.expression', 'punctuation.definition.tag',
    ]),
    rule(KEYWORD, [
      'keyword.operator.new', 'keyword.operator.expression', 'keyword.operator.wordlike', 'keyword.operator.delete',
      'keyword.operator.sizeof', 'keyword.operator.alignof', 'keyword.operator.cast', 'keyword.operator.instanceof',
      'keyword.operator.logical.python', 'keyword.operator.word', 'keyword.type.go',
    ]),
    rule(STRING, ['string', 'punctuation.definition.string', 'string keyword.codetag', 'markup.inline.raw', 'markup.inserted']),
    rule(FUNCTION, [
      'entity.name.function', 'support.function', 'meta.function-call entity.name.function', 'meta.function-call.generic',
      'entity.name.command', 'entity.other.attribute-name', 'markup.underline.link',
    ]),
    rule(TYPE, [
      'entity.name.type', 'entity.name.class', 'entity.name.struct', 'entity.name.namespace', 'entity.other.inherited-class',
      'support.type', 'support.class', 'keyword.type', 'keyword.other.type',
      'storage.type.primitive', 'storage.type.built-in', 'storage.type.builtin', 'storage.type.generic', 'storage.type.annotation',
      'storage.type.object.array', 'storage.type.java', 'storage.type.cs',
      'storage.type.numeric.go', 'storage.type.string.go', 'storage.type.boolean.go', 'storage.type.byte.go', 'storage.type.rune.go',
      'storage.type.uintptr.go', 'storage.type.error.go', 'variable.other.key.toml',
    ]),
    rule(NUMBER, ['constant.numeric', 'keyword.other.unit', 'markup.changed']),
    rule(CONSTANT, [
      'constant.language', 'constant.character', 'constant.other', 'support.constant', 'variable.other.enummember',
      'variable.language', 'markup.deleted',
    ]),
    rule(COMMENT, [
      'comment', 'punctuation.definition.comment', 'markup.quote', 'meta.diff.header',
      // Tags and types inside doc comments stay comment: one quiet voice per comment.
      'comment keyword', 'comment keyword.other.type', 'comment storage', 'comment storage.type', 'comment entity.name.type',
      'comment variable', 'comment constant', 'comment support', 'comment support.type', 'comment string', 'comment punctuation',
    ]),
  ],
};

/** The class a themed token's colour stands for; anything that is not a sentinel is plain text. */
export function classOfColor(color: string | undefined): TokenClass {
  const match = color ? /^#00000([1-7])$/.exec(color) : null;
  return match ? (Number(match[1]) as TokenClass) : PLAIN;
}
