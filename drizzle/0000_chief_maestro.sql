CREATE TABLE `pluts_accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`contra` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT "pluts_accounts_type_check" CHECK("pluts_accounts"."type" IN ('Asset','Liability','Equity','Revenue','Expense'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pluts_accounts_name_type_idx` ON `pluts_accounts` (`name`,`type`);--> statement-breakpoint
CREATE INDEX `pluts_accounts_type_idx` ON `pluts_accounts` (`type`,`name`);--> statement-breakpoint
CREATE TABLE `pluts_amounts` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`account_id` text NOT NULL,
	`entry_id` text NOT NULL,
	`amount` integer NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `pluts_accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`entry_id`) REFERENCES `pluts_entries`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `pluts_amounts_type_idx` ON `pluts_amounts` (`type`);--> statement-breakpoint
CREATE INDEX `pluts_amounts_account_entry_idx` ON `pluts_amounts` (`account_id`,`entry_id`);--> statement-breakpoint
CREATE INDEX `pluts_amounts_entry_account_idx` ON `pluts_amounts` (`entry_id`,`account_id`);--> statement-breakpoint
CREATE TABLE `pluts_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`description` text NOT NULL,
	`date` text NOT NULL,
	`commercial_document_id` text,
	`commercial_document_type` text,
	`posted_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `pluts_entries_date_idx` ON `pluts_entries` (`date`);--> statement-breakpoint
CREATE INDEX `pluts_entries_commercial_doc_idx` ON `pluts_entries` (`commercial_document_id`,`commercial_document_type`);--> statement-breakpoint
CREATE TABLE `pluts_entry_keys` (
	`key` text PRIMARY KEY NOT NULL,
	`entry_id` text NOT NULL,
	FOREIGN KEY (`entry_id`) REFERENCES `pluts_entries`(`id`) ON UPDATE no action ON DELETE no action
);
