import { stetForms } from '__FORMS_MODULE__';

export const POST = (req: Request) => stetForms('POST', req);
// Next answers OPTIONS itself unless the route exports it.
export const OPTIONS = (req: Request) => stetForms('OPTIONS', req);
