export type PipelineStage = "plan" | "sql" | "review" | "execution" | "quality" | "analysis";

export class PipelineStageError extends Error {
  sqlAttempts?: Array<{ attempt: number; sql: string; error: string }>;

  constructor(
    readonly stage: PipelineStage,
    message: string,
    readonly attempt = 1,
  ) {
    super(`[${stage}:${attempt}] ${message}`);
    this.name = "PipelineStageError";
  }
}

export async function atStage<T>(
  stage: PipelineStage,
  attempt: number,
  action: () => Promise<T>,
) {
  try {
    return await action();
  } catch (error) {
    if (error instanceof PipelineStageError) throw error;
    throw new PipelineStageError(
      stage,
      error instanceof Error ? error.message : String(error),
      attempt,
    );
  }
}
