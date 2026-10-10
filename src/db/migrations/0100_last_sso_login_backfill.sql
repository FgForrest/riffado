-- `users.last_sso_login_at` keeps a user's mail addresses receiving. New
-- in 0099, it would read as "never" for everyone and pause every address
-- until each person signs in again: start it at each single sign-on user's
-- newest session instead. Users without a single sign-on account keep null.
UPDATE "users" AS "u"
SET "last_sso_login_at" = "latest"."at"
FROM (
    SELECT "s"."user_id", max("s"."created_at") AS "at"
    FROM "sessions" AS "s"
    WHERE EXISTS (
        SELECT 1
        FROM "accounts" AS "a"
        WHERE "a"."user_id" = "s"."user_id"
            AND "a"."provider_id" = 'oidc'
    )
    GROUP BY "s"."user_id"
) AS "latest"
WHERE "u"."id" = "latest"."user_id"
    AND "u"."last_sso_login_at" IS NULL;
