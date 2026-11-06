const WORD = String.raw`[\p{L}\p{M}\p{N}]`;
const ATTACHED = String.raw`[\p{L}\p{M}\p{N}_'’]`;
// Match outer dialogue first. Only apostrophes inside a word may occur inside a marked thought.
const QUOTES = new RegExp([
  String.raw`«[^»\r\n]*»|“[^”\r\n]*”|"[^"\r\n]*"`,
  String.raw`(?<!${ATTACHED})'(?!['\s])((?:[^'\r\n]|(?<=${WORD})'(?=${WORD}))+?)(?<!\s)'(?!${ATTACHED})`,
  String.raw`‘(?![’\s])((?:[^’\r\n]|(?<=${WORD})’(?=${WORD}))+?)(?<!\s)’(?!${ATTACHED})`,
].join("|"), "gu");

function replaceChatThoughts(content: string, replace: (thought: string) => string): string {
  return content.replace(QUOTES, (full, straight?: string, curly?: string) => {
    const thought = straight ?? curly;
    return thought === undefined ? full : replace(thought);
  });
}

export function withoutChatThoughts(content: string, replacement = " "): string {
  return replaceChatThoughts(content, () => replacement);
}

export function formatChatMessage(content: string): string {
  const escaped = content.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const thoughts = replaceChatThoughts(escaped, text => `<em class="text-wd-secondary">${text.replaceAll("*", "&#42;")}</em>`);
  return thoughts.replace(/(\*{1,3})([^*\n]+?)\1/g, '<em class="text-wd-story-muted">$2</em>').replace(/\n/g, "<br />");
}
