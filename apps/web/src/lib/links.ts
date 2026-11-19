/**
 * A link to a page of Saldo itself, or null. Browsers read a backslash like a slash, so "/\host" would leave the site
 * just like "//host".
 */
export function internalLink(link: string | null | undefined): string | null {
  return typeof link === "string" && link.startsWith("/") && !link.startsWith("//") && !link.includes("\\") ? link : null;
}
