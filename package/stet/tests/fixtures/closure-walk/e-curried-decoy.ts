declare function connect(a: string): (b: string) => unknown;

export const decoy: unknown = connect('first')('./second.js');
export const named: unknown = connect('first')('second');
export const two: unknown = (connect as unknown as () => (a: string, b: string) => unknown)()('x', 'y');
