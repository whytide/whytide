// A registered code without its message key, and a spread member the check cannot read.
declare function defineErrors<T extends Record<string, { status: number }>>(codes: T): T;
declare const more: Record<string, { status: number }>;
export const errors = defineErrors({ missing_code: { status: 400 }, ...more });
