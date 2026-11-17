-- Ensure the Restaurant Suite application exists for tenant onboarding.
INSERT INTO applications(app_key,name,status)
VALUES ('restaurant','Restaurant Suite','active')
ON CONFLICT(app_key) DO NOTHING;
