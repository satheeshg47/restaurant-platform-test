export interface D1Result<T> {
  results: T[]
  success: boolean
  meta?: { changes?: number }
}

export interface D1Statement {
  bind(...values: unknown[]): D1Statement
  first<T = Record<string, unknown>>(): Promise<T | null>
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>
  run(): Promise<D1Result<never>>
}

export interface D1Database {
  prepare(sql: string): D1Statement
  batch<T = D1Result<never>>(statements: D1Statement[]): Promise<T[]>
}

export interface Env {
  DB: D1Database
  ASSETS: { fetch(request: Request): Promise<Response> }
  OIDC_ISSUER?: string
  OIDC_AUDIENCE?: string
  OIDC_CLIENT_ID?: string
  OIDC_JWKS_URL?: string
  PLATFORM_ADMIN_SUBJECT?: string
  ENVIRONMENT?: string
}

export interface Identity {
  issuer: string
  subject: string
  email?: string
  emailVerified?: boolean
}
