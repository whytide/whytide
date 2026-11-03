// The codes of the egress rules (alpha-p1-060): one per refusal, so the client of alpha-p1-065 and
// the api answer with the reason and never a sentence. A refusal is 400: the URL the caller gave is
// not one server code may fetch, whoever typed it. A malformed list entry is the server's
// configuration and keeps the default status. The client's own codes (alpha-p1-065) say what the far
// end did, answered as a gateway would, a redirect from https down to http included; options out of
// bounds are the caller's bug.
import { defineErrors } from "../errors/index.ts";

export const egressErrors = defineErrors({
  egress_invalid_url: { status: 400 },
  egress_bad_scheme: { status: 400 },
  egress_credentials_in_url: { status: 400 },
  egress_denied_host: { status: 400 },
  egress_blocked_address: { status: 400 },
  egress_port_not_allowed: { status: 400 },
  egress_invalid_host_entry: {},
  egress_dns_failed: { status: 502 },
  egress_too_many_redirects: { status: 502 },
  egress_insecure_redirect: { status: 502 },
  egress_too_large: { status: 502 },
  egress_timeout: { status: 504 },
  egress_request_failed: { status: 502 },
  egress_invalid_options: {},
});
