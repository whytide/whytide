// POST …/contacts/leads/{personId}/review, GET …/contacts/leads/{personId}/reviews and GET
// …/contacts/reviews/summary (README.md "Routes"), inside the request's tenant run like the lead
// routes (leads.controller.ts): a decision appended, a lead's history, a week's summary. No route
// updates or deletes a decision.
import { Body, Controller, Get, Param, Post, Query, SetMetadata } from "@nestjs/common";
import {
  listReviews,
  type ReviewDecision,
  reviewLead,
  reviewSummary,
} from "../domain/review/reviews.ts";
import { errors } from "../errors.ts";
import { permissions } from "../permissions.ts";
import { leadParams } from "../schemas/leads.ts";
import {
  type ReviewBody,
  type ReviewHistory,
  type ReviewResponse,
  type ReviewSummaryResponse,
  reviewBody,
  reviewHistory,
  reviewResponse,
  type SummaryQuery,
  reviewSummary as summaryAnswer,
  summaryQuery,
} from "../schemas/reviews.ts";

const route = (spec: Record<string, unknown>) => SetMetadata("whytide:api-route", spec);

@Controller()
export class ReviewsController {
  @Post("leads/:personId/review")
  @SetMetadata("whytide:permission", permissions["reviews.write"])
  @route({
    summary: "Appends a decision on the lead: Good lead with its text, or Not a fit with a code",
    params: leadParams,
    body: reviewBody,
    response: reviewResponse,
    errors: [
      errors.review_reason_required,
      errors.review_text_required,
      errors.contacts_input_invalid,
      errors.lead_not_found,
    ],
  })
  async review(
    @Param("personId") personId: string,
    @Body() body: ReviewBody,
  ): Promise<ReviewResponse> {
    return toReview(await reviewLead({ personId, ...body }));
  }

  @Get("leads/:personId/reviews")
  @SetMetadata("whytide:permission", permissions["reviews.read"])
  @route({
    summary: "The lead's review decisions, newest first",
    params: leadParams,
    response: reviewHistory,
    errors: [errors.lead_not_found],
  })
  async history(@Param("personId") personId: string): Promise<ReviewHistory> {
    return { reviews: (await listReviews(personId)).map(toReview) };
  }

  @Get("reviews/summary")
  @SetMetadata("whytide:permission", permissions["reviews.read"])
  @route({
    summary:
      "An ISO week's decisions and the good-lead rate of its top twenty qualified leads by fit",
    query: summaryQuery,
    response: summaryAnswer,
    errors: [errors.contacts_input_invalid],
  })
  async summary(@Query() { week }: SummaryQuery): Promise<ReviewSummaryResponse> {
    return reviewSummary(week);
  }
}

/** A decision as the routes answer it: no workspace. */
function toReview({
  workspaceId: _workspace,
  decidedAt,
  ...review
}: ReviewDecision): ReviewResponse {
  return { ...review, decidedAt: decidedAt.toISOString() };
}
