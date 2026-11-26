DROP INDEX "HouseholdMember_user_id_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "HouseholdMember_user_id_key" ON "HouseholdMember" USING btree ("user_id" text_ops);