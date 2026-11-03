// The Company Knowledge routes and the Draft (README "Routes"), which the api host mounts under
// /v1/workspaces/:workspaceId/onboarding: each handler runs in the request's tenant run, so the
// commands read and write through its transaction. A module cannot import the host: a route writes
// the host's metadata itself, its permission and its @ApiRoute (core/apps/api/README.md "Modules",
// "Permissions", "OpenAPI and the client").
import { Body, Controller, Get, HttpCode, Module, Post, Put, SetMetadata } from "@nestjs/common";
import { currentTenant } from "@whytide/platform";
import {
  type CompanyKnowledge,
  getCompanyKnowledge,
  saveCompanyKnowledge,
} from "../domain/commands.ts";
import { listWebsitePages, requestDraft } from "../domain/draft.ts";
import { acceptDraft, discardDraft } from "../domain/review.ts";
import { errors } from "../errors.ts";
import { permissions } from "../permissions.ts";
import {
  type AcceptDraftBody,
  acceptDraftBody,
  type CompanyKnowledgeBody,
  type CompanyKnowledgeResponse,
  companyKnowledgeBody,
  companyKnowledgeResponse,
} from "../schemas/company-knowledge.ts";

@Controller("company-knowledge")
export class CompanyKnowledgeController {
  @Get()
  @SetMetadata("whytide:permission", permissions["company_knowledge.read"])
  @SetMetadata("whytide:api-route", {
    summary: "The workspace's Company Knowledge; the first read creates it empty",
    response: companyKnowledgeResponse,
  })
  async read(): Promise<CompanyKnowledgeResponse> {
    return answer(await getCompanyKnowledge(currentTenant().workspaceId));
  }

  @Put()
  @SetMetadata("whytide:permission", permissions["company_knowledge.write"])
  @SetMetadata("whytide:api-route", {
    summary: "Saves the Company Knowledge; each changed field is marked human, the version moves",
    body: companyKnowledgeBody,
    response: companyKnowledgeResponse,
    errors: [errors.company_knowledge_invalid_url],
  })
  async write(@Body() body: CompanyKnowledgeBody): Promise<CompanyKnowledgeResponse> {
    return answer(await saveCompanyKnowledge(body));
  }

  @Post("draft")
  @HttpCode(202)
  @SetMetadata("whytide:permission", permissions["company_knowledge.write"])
  @SetMetadata("whytide:idempotent", true)
  @SetMetadata("whytide:api-route", {
    summary: "Drafts from the saved website: fetchStatus becomes fetching and the worker reads it",
    response: companyKnowledgeResponse,
    errors: [errors.company_knowledge_no_website],
  })
  async draft(): Promise<CompanyKnowledgeResponse> {
    return answer(await requestDraft(currentTenant().workspaceId));
  }

  @Post("draft/accept")
  @HttpCode(200)
  @SetMetadata("whytide:permission", permissions["company_knowledge.write"])
  @SetMetadata("whytide:idempotent", true)
  @SetMetadata("whytide:api-route", {
    summary: "Accepts the pending draft: each drafted field a person did not write is written",
    body: acceptDraftBody,
    response: companyKnowledgeResponse,
    errors: [errors.company_knowledge_no_draft],
  })
  async accept(@Body() body: AcceptDraftBody): Promise<CompanyKnowledgeResponse> {
    return answer(await acceptDraft(body.replaceEdited ?? false));
  }

  @Post("draft/discard")
  @HttpCode(200)
  @SetMetadata("whytide:permission", permissions["company_knowledge.write"])
  @SetMetadata("whytide:idempotent", true)
  @SetMetadata("whytide:api-route", {
    summary: "Discards the pending draft; the record keeps every field",
    response: companyKnowledgeResponse,
    errors: [errors.company_knowledge_no_draft],
  })
  async discard(): Promise<CompanyKnowledgeResponse> {
    return answer(await discardDraft());
  }
}

@Module({ controllers: [CompanyKnowledgeController] })
export class OnboardingApi {}

/** The record with the pages its last fetch read, as the routes answer it. */
async function answer(record: CompanyKnowledge): Promise<CompanyKnowledgeResponse> {
  const fetchedAt = record.fetchedAt?.toISOString() ?? null;
  const pages = (await listWebsitePages(record.id)).map((page) => ({
    ...page,
    fetchedAt: page.fetchedAt.toISOString(),
  }));
  return { ...record, fetchedAt, updatedAt: record.updatedAt.toISOString(), pages };
}
