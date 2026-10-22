import { auth } from "@/lib/firebase";
import { apiBase } from "@/services/apiClient";

const MAX_IMAGE_SIZE_BYTES = 5 * 1024 * 1024;
const ACCEPTED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

export type UploadListingImageResult = {
  success: true;
  url: string;
  path: string;
  filename: string;
  size: number;
};

export type UploadProfileAvatarResult = {
  success: true;
  avatarUrl: string;
  avatarPath: string;
  filename: string;
  size: number;
};

export async function uploadBackendListingImage(
  file: File
): Promise<UploadListingImageResult> {
  validateImageBeforeUpload(file);
  const user = auth.currentUser;
  if (!user) {
    throw new Error("User must be authenticated.");
  }
  const token = await user.getIdToken();

  const formData = new FormData();
  formData.append("image", file);

  const response = await fetch(`${apiBase()}/uploads/listing-image`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
    },
    body: formData,
  });
  if (!response.ok) {
    throw new Error(await uploadErrorMessage(response));
  }
  return (await response.json()) as UploadListingImageResult;
}

export async function uploadBackendProfileAvatar(
  file: File
): Promise<UploadProfileAvatarResult> {
  validateImageBeforeUpload(file);
  const user = auth.currentUser;
  if (!user) {
    throw new Error("User must be authenticated.");
  }
  const token = await user.getIdToken();

  const formData = new FormData();
  formData.append("image", file);

  const response = await fetch(`${apiBase()}/uploads/profile-avatar`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
    },
    body: formData,
  });
  if (!response.ok) {
    throw new Error(await uploadErrorMessage(response));
  }
  return (await response.json()) as UploadProfileAvatarResult;
}

export { uploadBackendListingImage as uploadImage };

function validateImageBeforeUpload(file: File): void {
  if (!ACCEPTED_IMAGE_TYPES.has(file.type)) {
    throw new Error("نوع الصورة غير مدعوم. استخدم JPG/PNG/WEBP.");
  }
  if (file.size > MAX_IMAGE_SIZE_BYTES) {
    throw new Error("الصورة تتجاوز 5MB.");
  }
}

async function uploadErrorMessage(response: Response): Promise<string> {
  const text = await response.text();
  try {
    const parsed = JSON.parse(text) as { code?: string; message?: string; error?: string };
    if (response.status === 429) return "طلبات كثيرة. انتظر قليلاً ثم حاول مرة أخرى.";
    if (parsed.code === "EMAIL_NOT_VERIFIED") return "يجب تأكيد البريد الإلكتروني قبل رفع الصور.";
    if (parsed.code === "ACCOUNT_NOT_ACTIVE") return "الحساب غير نشط ولا يمكنه رفع الصور.";
    return parsed.message || parsed.error || `Upload failed with ${response.status}`;
  } catch {
    return response.status === 429 ? "طلبات كثيرة. انتظر قليلاً ثم حاول مرة أخرى." : `Upload failed with ${response.status}`;
  }
}

