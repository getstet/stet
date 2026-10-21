'use client';
import { useState } from 'react';
export const Share = ({ url }: { url: string }) => { const [copied, set] = useState(false); const copy = (text: string, label: string) => navigator.clipboard.writeText(text).then(() => set(true)); return <button onClick={() => copy(url, 'link')}>{copied ? 'Copied' : 'Copy'}</button>; };
