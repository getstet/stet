import defaults from '@/content/defaults.json';
export const Foot = ({ which }: { which: string }) => <p>{defaults.default[which]}</p>;
