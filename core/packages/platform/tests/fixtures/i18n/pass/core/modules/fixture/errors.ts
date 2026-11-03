// The fixture module's error codes, in the shape alpha-p1-030 defines; the check reads the codes and never runs the file.
declare function defineErrors<T extends Record<string, { status: number }>>(codes: T): T;
export const errors = defineErrors({ thing_not_found: { status: 404 } });
