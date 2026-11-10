const isProduction = process.env.NODE_ENV === "production";

function required(name: string, devDefault: string): string {
  const value = process.env[name];
  if (value) return value;
  if (isProduction) throw new Error(`Missing required env var ${name}`);
  return devDefault;
}

export const config = {
  isProduction,
  port: Number(process.env.PORT) || 3001,
  databaseUrl: required("PGCONNECTIONSTRING", "postgresql://userx:pw@localhost:5432/bluestaq_dev?sslmode=disable"),
  jwtSecret: required("JWT_SECRET", "dev-only-secret-change-me"),
  seedAdminUsername: process.env.SEED_ADMIN_USERNAME || "admin",
  seedAdminPassword: required("SEED_ADMIN_PASSWORD", "admin123"),
};

export const SESSION_COOKIE = "session";
export const SESSION_TTL_SECONDS = 24 * 60 * 60;
