import { z } from "zod";
import { DOCUMENT_CATEGORIES, DOCUMENT_VISIBILITIES } from "@shared/domain";

export const documentMeta = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).nullish(),
  category: z.enum(DOCUMENT_CATEGORIES).default("OTHER"),
  visibility: z.enum(DOCUMENT_VISIBILITIES).default("ORG"),
  employeeId: z.string().uuid().nullish(),
  expiresOn: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullish(),
});
