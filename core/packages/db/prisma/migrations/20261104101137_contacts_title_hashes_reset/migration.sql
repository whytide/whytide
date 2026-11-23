-- The title is the assessment's since title-check-ai (qualification's README "The batch"; contacts'
-- README "Decided here"): no filter writes title_mismatch anymore, so a rejected candidate hashed for
-- its title alone is deleted, once, and the person is processed when they engage again. A hash with
-- another reason (the country, the size), none, or of kind erased stays as it is. Data only, and safe
-- on a database without such rows: it deletes none. The previous release, still running, may write
-- such a hash again until its worker stops; it then expires after its 90 days.

DELETE FROM "person_hashes"
WHERE "kind" = 'rejected_candidate'
  AND "drop_reasons" <> '{}'::jsonb
  AND ("drop_reasons" - 'title_mismatch') = '{}'::jsonb;
