-- ===========================================================================
-- Phase 2 cutover: backfill user_id on legacy single-user rows
-- ===========================================================================
-- Phase 1 rows were written with user_id NULL because currentUser() returned
-- {id:null} (see index.html sbBatchUpsert: user_id is stamped only when the
-- auth user id exists). The "own trades" RLS policies require auth.uid() =
-- user_id, so every legacy row would silently vanish once RLS is enabled.
--
-- Run order (before enabling the RLS policies in schema.sql):
--   1. DROP the anon quick-start policy if it was ever created.
--   2. Run this backfill with the owner's real auth.users id.
--   3. Enable the "own trades" / "own profile" policies.
--
-- For multi-user you must run this per owner before they can see their rows;
-- a single SQL statement cannot know who "the owner" is at cutover.
-- ===========================================================================

update trades
   set user_id = '<owner-uuid>'::uuid
 where user_id is null;
