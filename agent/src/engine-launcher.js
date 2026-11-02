export function parseSessionEnv(text) {
  return Object.fromEntries(text.split('\n').flatMap((line) => {
    const at = line.indexOf('=');
    return at > 0 ? [[line.slice(0, at), line.slice(at + 1)]] : [];
  }));
}
