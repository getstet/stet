import { copy } from '@/lib/content';
export const GET = () => new Response(copy('api_error'));
