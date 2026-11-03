// The settings this module reads, its block of deploy/.env.example (docs/rules/coding.md §3, §8):
// LINKEDIN_DAILY_READ_CAP_MAX, declared in config.ts. The adapter is the providers' PROVIDER_LINKEDIN,
// the hosted link's return address the api's APP_PUBLIC_ORIGIN, and the webhook's public URL the
// unipile adapter's UNIPILE_NOTIFY_URL (README.md "Settings").
export { linkedinConfig as settings } from "./config.ts";
