import { z } from "zod";

// Module-local DTOs. Cross-cutting entity schemas live in shared/schema/.
export const example__Name__Query = z.object({
  q: z.string().optional(),
});
