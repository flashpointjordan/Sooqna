export interface FavoriteRecord {
  id?: string;
  userId: string;
  listingId: string;
  createdAt: string;
  notificationVersion?: string;
  deletedAt?: string | null;
}

