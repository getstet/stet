/** A copy value with its `{{name}}` variables filled in. */
export function fill(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (whole, name: string) => vars[name] ?? whole);
}
