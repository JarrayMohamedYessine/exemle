import { Account, LangKey, UserRole } from "../types";

export interface AppNotification {
  id: string;
  recipientRole?: UserRole | "staff" | "all"; 
  targetEmail?: string; 
  targetUsername?: string;
  title: Record<LangKey, string>;
  message: Record<LangKey, string>;
  type: "doc_approved" | "doc_pinned" | "elite_upgrade" | "moderation_ban" | "admin_broadcast" | "report_alert" | "system";
  iconType?: "bell" | "shield" | "file-check" | "star" | "alert" | "message" | "check";
  badgeLabel?: Record<LangKey, string>;
  actionUrl?: string; 
  createdAt: number;
  readBy: string[]; 
  pinned?: boolean;
}

export const ONBOARDING_GUIDE_NOTIFICATION_ID = "notif-student-onboarding-guide-v1";

export function getOnboardingGuideNotification(user: Account): AppNotification {
  const guideMessageAr = `مرحباً بك في منصة SuperStudent الرسمية لمراجعة الباكالوريا وسنوات الثانوي في تونس 🇹🇳. إليك دليلك الشامل لتحقيق أعلى المراتب والتميز:

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📍 1. غرف المذاكرة التفاعلية لكل مادة:
• ادخل إلى قسم "شعب الباكالوريا" واختر مادتك لمناقشة التمارين مع زملائك من كامل أنحاء الجمهورية.
• يمكنك إرسال التمارين المعقدة والنقاش المنهجي مع المشرفين والتلاميذ المتميزين (Elite Students).
• المحادثات مراقبة آلياً لضمان بيئة تربوية هادئة ونقية من أي تشويش.

📍 2. تبادل الصور والمستندات وPDF:
• تظهر الصور مباشرة داخل المحادثة بشكل مصغر وأنيق (ألبوم صور متناسق).
• عند النقر على أي صورة، تُفتح في وضع ملء الشاشة الفوري مع إمكانية التحميل عالي الدقة أو التصفح بين الصور.
• يمكنك إرفاق حتى ملفين PDF في كل رسالة أو تمرين (مثل إرفاق الامتحان مع بطاقة الإصلاح النموذجي).

📍 3. بنك الامتحانات والأرشيف الوطني:
• يحتوي الأرشيف على جميع امتحانات الباكالوريا الرسمية التونسية (الدورة الرئيسية ودورة المراقبة).
• يمكن لجميع التلاميذ المسجلين تصفح وتحميل الفروض، التلاخيص، وسلالم التقييم (Barèmes) مجاناً.

📍 4. أداة التوجيه الجامعي 2026:
• حساب السكور ومطابقة الشعب والجامعات التونسية وفق دليل التوجيه الرسمي.

📍 5. ميثاق الشرف الأخلاقي وحماية الحساب:
• يُمنع نشر أي محتوى خارج عن النطاق التربوي أو استخدام ألفاظ غير لائقة.
• الإدارة تطبق نظام الحظر التلقائي والفوري على أي حساب يخالف ميثاق الاحترام المتبادل.

نتمنى لك رحلة مراجعة ممتعة، مليئة بالجد والمثابرة، وتتويجاً بالنجاح الباهر ومعدل استثنائي في الباكالوريا! 🌟`;

  const guideMessageFr = `Bienvenue sur la plateforme officielle SuperStudent pour le Baccalauréat tunisien 🇹🇳. Voici votre guide complet pour réussir avec excellence :

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📍 1. Salles de Révision par Matière :
• Accédez aux salons dédiés de votre section pour échanger avec vos camarades partout en Tunisie.
• Posez vos questions et débattez des méthodes avec les Modérateurs et Élèves Élite.

📍 2. Partage d'Images et Documents PDF :
• Les images s'affichent en album interactif avec zoom plein écran et téléchargement instantané.
• Possibilité d'attacher jusqu'à 2 fichiers PDF par message (par exemple une épreuve et son corrigé).

📍 3. Banque d'Épreuves Officielles :
• Téléchargement libre et illimité de toutes les sessions du Bac tunisien avec barèmes officiels.

📍 4. Guide d'Orientation Universitaire 2026 :
• Calcul de score FG et recherche des filières universitaires officielles.

📍 5. Charte de Respect :
• Tout propos inapproprié entraîne une sanction immédiate.

Excellente réussite dans votre préparation du Baccalauréat ! 🌟`;

  return {
    id: `${ONBOARDING_GUIDE_NOTIFICATION_ID}-${(user.email || user.username || "").toLowerCase()}`,
    targetEmail: (user.email || "").toLowerCase(),
    targetUsername: user.username,
    title: {
      ar: "📘 دليل الاستعمال الشامل والتوجيهات الذهبية للنجاح في الباكالوريا 🇹🇳",
      fr: "📘 Guide d'Utilisation Complet & Conseils Clés pour le Bac 🇹🇳",
      en: "📘 Comprehensive User Guide & Golden Keys to Baccalaureate Success 🇹🇳",
    },
    message: {
      ar: guideMessageAr,
      fr: guideMessageFr,
      en: guideMessageAr,
    },
    type: "system",
    iconType: "star",
    badgeLabel: {
      ar: "دليل الاستعمال الرسمي",
      fr: "Guide Officiel",
      en: "Official Guide",
    },
    actionUrl: "home",
    createdAt: Date.now(),
    readBy: [],
    pinned: true,
  };
}

export async function getAllNotifications(): Promise<AppNotification[]> {
  return [];
}

export async function getUserNotifications(user: Account | null): Promise<AppNotification[]> {
  return user ? [getOnboardingGuideNotification(user)] : [];
}

export function isNotificationUnread(notif: AppNotification, user: Account | null): boolean {
  if (!user) return false;
  const userIdentifier = (user.email || user.username || "").toLowerCase();
  return !notif.readBy.some((id) => id.toLowerCase() === userIdentifier);
}

export async function markNotificationAsRead(notifId: string, user: Account): Promise<void> {
  return;
}

export async function markAllNotificationsAsRead(user: Account): Promise<void> {
  return;
}

export async function createNotification(
  notif: Omit<AppNotification, "id" | "createdAt" | "readBy">
): Promise<AppNotification> {
  return { ...notif, id: `notif-${Date.now()}`, createdAt: Date.now(), readBy: [] };
}

export async function clearAllNotifications(): Promise<void> {
  return;
}
