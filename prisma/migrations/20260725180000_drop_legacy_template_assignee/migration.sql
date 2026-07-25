-- Drop the never-used single-assignee column on TaskTemplate.
-- Superseded by `defaultAssigneeIds` (Json uuid[]) added with internal task templates;
-- the app has always written the plural field, never this one.
ALTER TABLE "TaskTemplate" DROP CONSTRAINT "TaskTemplate_defaultAssigneeId_fkey";
ALTER TABLE "TaskTemplate" DROP COLUMN "defaultAssigneeId";
