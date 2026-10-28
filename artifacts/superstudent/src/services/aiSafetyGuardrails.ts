
export interface SafetyCheckResult {
  isSafe: boolean;
  sanitizedPrompt: string;
  piiDetected: boolean;
  piiTypes: string[];
  flaggedCategories: string[];
  blockReason?: string;
  safetyScore: number; 
  advice?: string;
}

const PII_PATTERNS = {
  tunisianCIN: /\b(CIN|بطاقة\s*تعريف|ب\.ت\.ن|cin)\s*[:=]?\s*([0-9]{8})\b/gi,
  standaloneCIN: /\b(0[0-9]{7}|1[0-9]{7})\b/g, // Standard 8 digits starting with 0 or 1
  
  tunisianPhone: /(?:\+?216\s*)?(?:[2459][0-9]{7}|[7][0-9]{7})\b/g,
  
  email: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,7}\b/g,
  
  passwords: /\b(mot\s*de\s*passe|password|كلمة\s*السر|mdp)\s*[:=]\s*(\S+)/gi,
};

const JAILBREAK_SIGNATURES = [
  /ignore\s+(all\s+)?(previous|prior)\s+instructions/i,
  /تجاهل\s+(جميع\s+)?(التعليمات|الأوامر)\s+(السابقة|الأصلية)/i,
  /you\s+are\s+now\s+in\s+developer\s+mode/i,
  /system\s+prompt\s+(leak|override|reveal)/i,
  /act\s+as\s+DAN\s+/i,
  /bypass\s+(safety|content\s+filter|guardrail)/i,
  /disable\s+all\s+rules/i,
  /أنت\s+الآن\s+بدون\s+قيود/i,
  /اكشف\s+(لي\s+)?التعليمات\s+السرية/i,
];

const HARMFUL_CONTENT_PATTERNS = [
  /\b(شتيمة|قذف|إهانة|كفر|سب|bastard|connard|enculé|salope)\b/i,
  /\b(انتحار|صنع\s+متفجرات|سلاح\s+ناري|suicide|fabrication\s+bombe|explosifs)\b/i,
  /\b(إباحي|جنسي|porn|sexe\s+explicite|nude)\b/i,
];

export function inspectAndSanitizeInput(prompt: string, lang: "ar" | "fr" = "ar"): SafetyCheckResult {
  if (!prompt || typeof prompt !== "string") {
    return {
      isSafe: true,
      sanitizedPrompt: "",
      piiDetected: false,
      piiTypes: [],
      flaggedCategories: [],
      safetyScore: 100,
    };
  }

  let sanitized = prompt;
  const piiTypes: string[] = [];
  const flaggedCategories: string[] = [];
  let isSafe = true;
  let blockReason: string | undefined;
  let safetyScore = 100;

  for (const pattern of JAILBREAK_SIGNATURES) {
    if (pattern.test(sanitized)) {
      flaggedCategories.push("Prompt Injection / Jailbreak Attempt");
      safetyScore -= 40;
      sanitized = sanitized.replace(pattern, "[Instruction Neutralized by Safety Guardrail]");
    }
  }

  for (const pattern of HARMFUL_CONTENT_PATTERNS) {
    if (pattern.test(sanitized)) {
      isSafe = false;
      flaggedCategories.push("Inappropriate / Harmful Content");
      safetyScore = 0;
      blockReason =
        lang === "ar"
          ? "تم حجب هذا الطلب تلقائياً بواسطة نظام الحماية (AI Content Safety) لاحتوائه على كلمات غير ملائمة للبيئة التعليمية."
          : "Cette requête a été bloquée automatiquement par le système de sécurité (AI Content Safety) car elle contient un contenu inapproprié au cadre éducatif.";
      return {
        isSafe: false,
        sanitizedPrompt: "",
        piiDetected: false,
        piiTypes: [],
        flaggedCategories,
        blockReason,
        safetyScore: 0,
        advice: lang === "ar" ? "يرجى الالتزام بالاستفسارات الأكاديمية والتربوية الخاصة بمواد الباكالوريا." : "Veuillez poser des questions strictement pédagogiques liées au Baccalauréat.",
      };
    }
  }

  if (PII_PATTERNS.tunisianCIN.test(sanitized)) {
    piiTypes.push("Tunisian CIN");
    sanitized = sanitized.replace(PII_PATTERNS.tunisianCIN, "$1: [CIN_PROTECTED_***]");
    safetyScore -= 10;
  }

  if (PII_PATTERNS.tunisianPhone.test(sanitized)) {
    piiTypes.push("Phone Number");
    sanitized = sanitized.replace(PII_PATTERNS.tunisianPhone, "[PHONE_REDACTED_***]");
    safetyScore -= 10;
  }

  if (PII_PATTERNS.email.test(sanitized)) {
    piiTypes.push("Email Address");
    sanitized = sanitized.replace(PII_PATTERNS.email, "[EMAIL_PROTECTED]");
    safetyScore -= 5;
  }

  if (PII_PATTERNS.passwords.test(sanitized)) {
    piiTypes.push("Password/Credential");
    sanitized = sanitized.replace(PII_PATTERNS.passwords, "$1: [PASSWORD_PROTECTED_***]");
    safetyScore -= 15;
  }

  const piiDetected = piiTypes.length > 0;

  return {
    isSafe: true,
    sanitizedPrompt: sanitized,
    piiDetected,
    piiTypes,
    flaggedCategories,
    safetyScore: Math.max(safetyScore, 20),
    advice: piiDetected
      ? lang === "ar"
        ? "🛡️ تنبيه أمان: تم حجب وإخفاء معطياتك الشخصية تلقائياً بواسطة درع الحماية لحماية خصوصيتك."
        : "🛡️ Sécurité : Vos données personnelles ont été masquées automatiquement par le bouclier de confidentialité."
      : undefined,
  };
}

const rateLimitCache = new Map<string, { count: number; resetTime: number }>();

export function checkRateLimit(clientIp: string, maxQueriesPerMinute = 30): { allowed: boolean; remaining: number; resetSeconds: number } {
  const now = Date.now();
  const windowMs = 60 * 1000;
  const record = rateLimitCache.get(clientIp);

  if (!record || now > record.resetTime) {
    rateLimitCache.set(clientIp, { count: 1, resetTime: now + windowMs });
    return { allowed: true, remaining: maxQueriesPerMinute - 1, resetSeconds: 60 };
  }

  if (record.count >= maxQueriesPerMinute) {
    const resetSeconds = Math.ceil((record.resetTime - now) / 1000);
    return { allowed: false, remaining: 0, resetSeconds };
  }

  record.count += 1;
  return {
    allowed: true,
    remaining: maxQueriesPerMinute - record.count,
    resetSeconds: Math.ceil((record.resetTime - now) / 1000),
  };
}

export function sanitizeAiResponseText(text: string): string {
  if (!text) return "";
  let cleaned = text;

  cleaned = cleaned.replace(/##@##&-##62#/gi, "");
  cleaned = cleaned.replace(/##@##(?:&?-?##?\d*#?)?/gi, "");
  cleaned = cleaned.replace(/&-?##\d+#?/gi, "");
  cleaned = cleaned.replace(/##\d{2,4}#/gi, "");
  cleaned = cleaned.replace(/#{2,}[@&%*^~_+-]+#{2,}[\w#&%@~-]*/gi, "");
  cleaned = cleaned.replace(/#{4,}\${3,}/g, "");
  cleaned = cleaned.replace(/!+؛:؛!+#+¥+¢+/g, "");

  cleaned = cleaned.replace(/&#62;/gi, ">");
  cleaned = cleaned.replace(/&#60;/gi, "<");
  cleaned = cleaned.replace(/&#38;/gi, "&");
  cleaned = cleaned.replace(/&#35;/gi, "#");
  cleaned = cleaned.replace(/&#64;/gi, "@");

  cleaned = cleaned.replace(/\n{3,}/g, "\n\n");

  return cleaned.trim();
}
