import { stetForms } from '__FORMS_MODULE__';

export const GET = (req: Request) => stetForms('GET', req);
export const POST = (req: Request) => stetForms('POST', req);
