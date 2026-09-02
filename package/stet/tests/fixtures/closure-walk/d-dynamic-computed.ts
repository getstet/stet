const spec = 'marker-computed';
export async function load(): Promise<unknown> {
  return import(`${spec}`);
}
