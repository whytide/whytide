// onboarding's screens (core/apps/web/docs/screens.md): the Company Knowledge at
// /w/{workspace}/company, the first step of the tester's day; and the prompt to build it from the
// website, which `pnpm web:routes` puts in the workspace home's `home` slot.
export const nav = [
  {
    group: "company",
    labelKey: "onboarding.company.title",
    segment: "company",
    screen: "company",
    order: 10,
    icon: "Building2",
  },
];
export const slots = [{ slot: "home", screen: "get-started" }];
