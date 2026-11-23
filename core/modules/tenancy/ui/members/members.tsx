"use client";
// The members, loaded in the browser (README.md "Members"): the loading state, the error state with a
// retry, then the workspace's members, Owners first, each with their name, email and role, "You" on
// the caller's own row. The caller's role is their own row's: an Owner (MEMBERS_MANAGE_ROLES) has a
// role menu and Remove on every other row, Remove after a confirmation that says what the member
// leaves behind, and a link to identity's Invites; a Member reads the list only. A refused change,
// last_owner or member_is_self among them, shows in words above the list, read again after it.
import {
  Avatar,
  Badge,
  Button,
  ButtonLink,
  Dialog,
  EmptyState,
  ErrorState,
  LoadingState,
  Select,
} from "@whytide/ui";
import { UserMinus, UserPlus } from "@whytide/ui/icons";
import { ApiError, browserApi, data } from "@whytide/web/api/browser";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import { MEMBER_ROLES, MEMBERS_MANAGE_ROLES } from "../../domain/constants.ts";
import type { MemberResponse } from "../../schemas/members.ts";

type MemberRole = (typeof MEMBER_ROLES)[number];
const codeOf = (error: unknown) => (error instanceof ApiError ? error.code : "internal_error");
const isMemberRole = (role: string): role is MemberRole => MEMBER_ROLES.some((one) => one === role);
const nameOf = (member: MemberResponse) => member.displayName ?? member.email;

export function Members({ workspaceId }: { workspaceId: string }) {
  const t = useTranslations("tenancy.members");
  /** Undefined while it loads. */
  const [members, setMembers] = useState<MemberResponse[]>();
  /** The list's read that failed. */
  const [failure, setFailure] = useState<string>();
  /** A change or a removal the API refused. */
  const [refusal, setRefusal] = useState<string>();
  /** The membership a change or a removal is on. */
  const [busy, setBusy] = useState<string>();
  const [removing, setRemoving] = useState<MemberResponse>();

  const load = useCallback(async () => {
    try {
      const answer = await data(
        browserApi().GET("/v1/workspaces/{workspaceId}/tenancy/members", {
          params: { path: { workspaceId } },
        }),
      );
      setMembers(answer.members);
      setFailure(undefined);
    } catch (error) {
      setFailure(codeOf(error));
    }
  }, [workspaceId]);

  useEffect(() => {
    void load();
  }, [load]);

  /** The change, shown at once; the list read again after it shows what the API kept. */
  async function changeRole(member: MemberResponse, role: MemberRole) {
    const { membershipId } = member;
    setRefusal(undefined);
    setBusy(membershipId);
    setMembers((all) =>
      all?.map((one) => (one.membershipId === membershipId ? { ...one, role } : one)),
    );
    try {
      await data(
        browserApi().PATCH("/v1/workspaces/{workspaceId}/tenancy/members/{membershipId}", {
          params: { path: { workspaceId, membershipId } },
          body: { role },
        }),
      );
    } catch (error) {
      setRefusal(codeOf(error));
    }
    await load();
    setBusy(undefined);
  }

  async function remove(member: MemberResponse) {
    const { membershipId } = member;
    setRemoving(undefined);
    setRefusal(undefined);
    setBusy(membershipId);
    try {
      await data(
        browserApi().DELETE("/v1/workspaces/{workspaceId}/tenancy/members/{membershipId}", {
          params: { path: { workspaceId, membershipId } },
        }),
      );
    } catch (error) {
      setRefusal(codeOf(error));
    }
    await load();
    setBusy(undefined);
  }

  if (members === undefined) {
    if (failure === undefined) return <LoadingState />;
    return <ErrorState module="tenancy" code={failure} onRetry={load} />;
  }
  const self = members.find((member) => member.isSelf);
  const manages = MEMBERS_MANAGE_ROLES.some((role) => role === self?.role);
  const roleText = { Owner: t("role.owner"), Admin: t("role.admin"), Member: t("role.member") };
  const roleOptions = MEMBER_ROLES.map((role) => ({ value: role, label: roleText[role] }));
  const invite = manages ? (
    <ButtonLink href={`/w/${workspaceId}/invites`}>
      <UserPlus aria-hidden="true" />
      {t("invite")}
    </ButtonLink>
  ) : null;
  return (
    <div className="grid gap-4">
      {invite ? <div className="flex justify-end">{invite}</div> : null}
      {failure ? <ErrorState module="tenancy" code={failure} onRetry={load} /> : null}
      {refusal ? <ErrorState module="tenancy" code={refusal} /> : null}
      {members.length === 0 ? (
        <EmptyState message={t("empty")} action={invite} />
      ) : (
        <ul className="divide-y divide-line rounded-xl border border-line bg-surface px-4 shadow-xs">
          {members.map((member) => {
            const name = nameOf(member);
            const controls = manages && !member.isSelf;
            return (
              <li
                key={member.membershipId}
                className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3"
              >
                <Avatar name={name} />
                <div className="grid min-w-0 flex-1 basis-40">
                  <span className="flex flex-wrap items-center gap-2 font-medium text-ink">
                    <span className="break-all">{name}</span>
                    {member.isSelf ? <Badge tone="accent">{t("you")}</Badge> : null}
                  </span>
                  {member.displayName === null ? null : (
                    <span className="break-all text-sm text-ink-muted">{member.email}</span>
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {/* A field is min-w-64 wide: the role menu is the row's, its label read aloud only. */}
                  {controls && isMemberRole(member.role) ? (
                    <div className="w-32 [&_.wt-field]:min-w-0 [&_.wt-field>label]:sr-only">
                      <Select
                        label={t("role.label", { name })}
                        value={member.role}
                        options={roleOptions}
                        disabled={busy !== undefined}
                        onChange={(event) => {
                          const role = event.target.value;
                          if (isMemberRole(role)) void changeRole(member, role);
                        }}
                      />
                    </div>
                  ) : (
                    <Badge tone={member.role === "Owner" ? "accent" : "neutral"}>
                      {roleText[member.role]}
                    </Badge>
                  )}
                  {controls ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={t("remove.label", { name })}
                      loading={busy === member.membershipId}
                      disabled={busy !== undefined && busy !== member.membershipId}
                      onClick={() => setRemoving(member)}
                    >
                      <UserMinus aria-hidden="true" />
                      {t("remove.action")}
                    </Button>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <Dialog
        open={removing !== undefined}
        onClose={() => setRemoving(undefined)}
        title={t("remove.title", { name: removing ? nameOf(removing) : "" })}
        actions={
          <Button variant="danger" onClick={() => removing && remove(removing)}>
            <UserMinus aria-hidden="true" />
            {t("remove.action")}
          </Button>
        }
      >
        <div className="grid gap-3 text-ink-muted">
          <p>{t("remove.body")}</p>
          <ul className="grid list-disc gap-1 ps-5">
            <li>{t("remove.linkedin")}</li>
            <li>{t("remove.mailbox")}</li>
            <li>{t("remove.agents")}</li>
            <li>{t("remove.campaigns")}</li>
          </ul>
          <p>{t("remove.again")}</p>
        </div>
      </Dialog>
    </div>
  );
}
