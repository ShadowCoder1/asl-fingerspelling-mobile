/* sign-quiz-key.js: how the sign quiz checks an answer without the page saying which option is right. The key is
 * SHA-256 of salt|question id|option; the page hashes the chosen option and compares. Not a lock (four options can
 * be hashed by anyone who reads this file), just not an answer sheet in plain sight. Works in the browser and in
 * Node (both have crypto.subtle). */
export const KEY_SALT = "asl-sign-quiz-v1";

export async function answerKey(qid, option) {
  const bytes = new TextEncoder().encode(`${KEY_SALT}|${qid}|${option}`);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}
