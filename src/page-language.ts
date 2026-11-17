// The languages the page speaks: English, and Ukrainian. Which one is the
// user's choice, kept with their settings (settings.ts) so it holds for
// every repository they open; the server writes it into the page it serves
// (`<html lang>`), and the page's own words are web/src/i18n.ts's. What
// archdiff writes about the code — the pages, the Mermaid, the names on a
// picture — is the same in both: it is what the CLI prints, a file in the
// repository, a comment on a pull request.
//
// Entry points: `PAGE_LANGUAGES`, `PageLanguage`, `isPageLanguage`.

/** The languages by their code, each under the name it calls itself. */
export const PAGE_LANGUAGES = { en: "English", uk: "Українська" } as const;

export type PageLanguage = keyof typeof PAGE_LANGUAGES;

export function isPageLanguage(value: unknown): value is PageLanguage {
  return typeof value === "string" && Object.hasOwn(PAGE_LANGUAGES, value);
}
