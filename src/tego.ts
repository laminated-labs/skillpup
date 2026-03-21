import { z } from "zod";

const skillSummarySchema = z
  .object({
    id: z.string().min(1),
    skill_name: z.string().min(1),
    skill_description: z.string().optional(),
    overall_risk: z.string().optional(),
    analysis_timestamp: z.string().optional(),
    owner_login: z.string().optional(),
    avatar_url: z.string().optional(),
    stars: z.number().optional(),
    repo_full_name: z.string().optional(),
    github_html_url: z.string().optional(),
    capabilities: z.unknown().optional(),
  })
  .passthrough();

const skillsListResponseSchema = z
  .object({
    skills: z.array(skillSummarySchema),
    count: z.number(),
    cursor: z.string().nullable().optional(),
  })
  .passthrough();

const assessmentResponseSchema = z
  .object({
    id: z.string().min(1),
    skill_name: z.string().min(1),
    sha: z.string().optional(),
    scan_date: z.string().optional(),
    assessment: z.unknown().optional(),
  })
  .passthrough();

export type TegoSkillSummary = z.infer<typeof skillSummarySchema>;
export type TegoAssessment = z.infer<typeof assessmentResponseSchema>;

export type NormalizedFinding = {
  severity: string;
  title: string;
  category?: string;
};

export type NormalizedPermission = {
  permission: string;
  necessity?: string;
};

export type NormalizedCapability = {
  name: string;
  riskLevel?: string;
};

type TegoClientOptions = {
  apiKey: string;
  baseUrl?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function normalizeAssessmentPayload(assessment: unknown): {
  findings: NormalizedFinding[];
  permissions: NormalizedPermission[];
  capabilities: NormalizedCapability[];
} {
  if (!isRecord(assessment)) {
    return {
      findings: [],
      permissions: [],
      capabilities: [],
    };
  }

  const findings = Array.isArray(assessment.findings)
    ? assessment.findings
        .filter(isRecord)
        .map((finding) => ({
          severity:
            typeof finding.severity === "string" ? finding.severity : "unknown",
          title: typeof finding.title === "string" ? finding.title : undefined,
          category:
            typeof finding.category === "string" ? finding.category : undefined,
        }))
        .filter(
          (finding): finding is NormalizedFinding => Boolean(finding.title)
        )
    : [];

  const rawPermissions = Array.isArray(assessment.permissions_requested)
    ? assessment.permissions_requested
    : Array.isArray(assessment.permissionsRequested)
      ? assessment.permissionsRequested
      : [];
  const permissions = rawPermissions
    .filter(isRecord)
    .map((permission) => ({
      permission:
        typeof permission.permission === "string" ? permission.permission : undefined,
      necessity:
        typeof permission.necessity === "string" ? permission.necessity : undefined,
    }))
    .filter(
      (permission): permission is NormalizedPermission => Boolean(permission.permission)
    );

  const capabilities: NormalizedCapability[] = [];
  if (isRecord(assessment.capabilities)) {
    for (const [name, capability] of Object.entries(assessment.capabilities)) {
      if (typeof capability === "boolean") {
        if (capability) {
          capabilities.push({ name });
        }
        continue;
      }

      if (!isRecord(capability)) {
        continue;
      }

      const detected =
        typeof capability.detected === "boolean" ? capability.detected : false;
      const riskLevel =
        typeof capability.risk_level === "string" ? capability.risk_level : undefined;
      if (!detected && !riskLevel) {
        continue;
      }

      capabilities.push({
        name,
        riskLevel,
      });
    }
  }

  return {
    findings,
    permissions,
    capabilities,
  };
}

export function createTegoClient(options: TegoClientOptions) {
  const baseUrl =
    options.baseUrl ??
    process.env.SKILLPUP_TEGO_BASE_URL ??
    "https://index.tego.security";
  const ownerCache = new Map<string, Promise<TegoSkillSummary[]>>();
  const assessmentCache = new Map<string, Promise<TegoAssessment>>();

  async function requestJson<T>(
    pathname: string,
    schema: z.ZodType<T>,
    searchParams?: URLSearchParams
  ) {
    const url = new URL(pathname, baseUrl);
    if (searchParams) {
      url.search = searchParams.toString();
    }

    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        Accept: "application/json",
      },
    });

    if (response.status === 401) {
      throw new Error("Tego API rejected TEGO_API_KEY.");
    }

    if (!response.ok) {
      throw new Error(
        `Tego API request failed: ${response.status} ${response.statusText}`
      );
    }

    const payload = await response.json();
    return schema.parse(payload);
  }

  async function searchSkillsByOwner(owner: string) {
    const cacheKey = owner.toLowerCase();
    const existing = ownerCache.get(cacheKey);
    if (existing) {
      return existing;
    }

    const next = (async () => {
      const skills: TegoSkillSummary[] = [];
      let cursor: string | undefined;

      for (;;) {
        const params = new URLSearchParams({
          owner,
          limit: "100",
        });
        if (cursor) {
          params.set("cursor", cursor);
        }

        const page = await requestJson(
          "/api/skills/search",
          skillsListResponseSchema,
          params
        );
        skills.push(...page.skills);
        if (!page.cursor) {
          break;
        }
        cursor = page.cursor;
      }

      return skills;
    })();

    ownerCache.set(cacheKey, next);
    return next;
  }

  async function getSkillAssessment(id: string) {
    const existing = assessmentCache.get(id);
    if (existing) {
      return existing;
    }

    const next = requestJson(
      `/api/skills/${encodeURIComponent(id)}/assessment`,
      assessmentResponseSchema
    );
    assessmentCache.set(id, next);
    return next;
  }

  return {
    searchSkillsByOwner,
    getSkillAssessment,
  };
}
