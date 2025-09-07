---
sidebar_position: 6
title: Cloudflare R2 Remote Cache
---

# Cloudflare R2 Remote Cache

Cloudflare R2 is a cost-effective object storage service that's S3-compatible and can serve as an excellent remote cache backend for `lage`. R2 offers zero egress fees, making it particularly attractive for CI/CD scenarios where cache downloads are frequent.

## Why Cloudflare R2?

- **Zero egress fees**: No charges for downloading cached artifacts
- **S3-compatible API**: Familiar interface with broad tooling support
- **Global distribution**: Fast access from Cloudflare's edge network
- **Cost-effective**: Competitive pricing for storage
- **High performance**: Low latency access to cached builds

## Setting up Cloudflare R2 Remote Cache

### 1. Create an R2 Bucket

1. Log into your Cloudflare dashboard
2. Navigate to **R2 Object Storage**
3. Click **Create bucket**
4. Choose a bucket name (e.g., `my-project-lage-cache`)
5. Select a location close to your CI/CD infrastructure

### 2. Generate R2 API Token

1. Go to **My Profile** → **API Tokens**
2. Click **Create Token**
3. Use the **Custom Token** template
4. Configure the token:
   - **Account**: Select your account
   - **Permissions**: 
     - `Cloudflare R2:Edit` (for read/write access)
     - Or `Cloudflare R2:Read` (for read-only access in development)
   - **Account Resources**: Include your account
   - **Zone Resources**: Not needed for R2
5. Save the token securely

### 3. Configure Environment Variables

Create a `.env` file in your project root:

```bash
# .env
BACKFILL_CACHE_PROVIDER="cloudflare-r2"
BACKFILL_CACHE_PROVIDER_OPTIONS='{"accountId":"your-account-id","bucket":"my-project-lage-cache","apiToken":"your-r2-api-token"}'
```

Add to your `.gitignore`:
```txt
.env
node_modules
lib
dist
```

### 4. Find Your Account ID

Your Cloudflare account ID can be found in the right sidebar of any Cloudflare dashboard page, or in the R2 overview page.

## Configuration Options

### Basic Configuration

```json
{
  "accountId": "your-cloudflare-account-id",
  "bucket": "your-r2-bucket-name", 
  "apiToken": "your-r2-api-token"
}
```

### Advanced Configuration

```json
{
  "accountId": "your-cloudflare-account-id",
  "bucket": "your-r2-bucket-name",
  "apiToken": "your-r2-api-token",
  "region": "auto",
  "maxSize": 104857600,
  "endpoint": "https://your-account-id.r2.cloudflarestorage.com"
}
```

**Configuration Options:**

| Option | Type | Required | Default | Description |
|--------|------|----------|---------|-------------|
| `accountId` | string | ✅ | - | Your Cloudflare account ID |
| `bucket` | string | ✅ | - | R2 bucket name |
| `apiToken` | string | ✅ | - | R2 API token with appropriate permissions |
| `region` | string | ❌ | `"auto"` | AWS region (use "auto" for R2) |
| `maxSize` | number | ❌ | undefined | Maximum file size in bytes to cache |
| `endpoint` | string | ❌ | Auto-generated | Custom R2 endpoint URL |

## CI/CD Setup

### GitHub Actions

```yaml
name: Build with R2 Cache

on: [push, pull_request]

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      
      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '18'
          
      - name: Install dependencies
        run: yarn install --frozen-lockfile
        
      - name: Build with R2 cache
        run: yarn lage build test --verbose
        env:
          BACKFILL_CACHE_PROVIDER: cloudflare-r2
          BACKFILL_CACHE_PROVIDER_OPTIONS: ${{ secrets.R2_CACHE_OPTIONS }}
          LAGE_WRITE_REMOTE_CACHE: true
```

**Secrets Configuration:**

Create a GitHub secret named `R2_CACHE_OPTIONS`:
```json
{"accountId":"your-account-id","bucket":"your-cache-bucket","apiToken":"your-r2-token-with-write-access"}
```

### Local Development

For local development, use a read-only token to benefit from cache downloads without accidentally modifying the cache:

```bash
# .env.local (for development)
BACKFILL_CACHE_PROVIDER="cloudflare-r2"
BACKFILL_CACHE_PROVIDER_OPTIONS='{"accountId":"your-account-id","bucket":"your-cache-bucket","apiToken":"your-readonly-r2-token"}'
# Note: LAGE_WRITE_REMOTE_CACHE is not set, so no uploads
```

## Best Practices

### 1. Use Different Buckets for Different Environments

```bash
# Production
BUCKET_NAME="myapp-cache-prod"

# Staging  
BUCKET_NAME="myapp-cache-staging"

# Development branches
BUCKET_NAME="myapp-cache-dev"
```

### 2. Configure Lifecycle Rules

Set up R2 lifecycle rules to automatically clean up old cache entries:

1. Go to your R2 bucket settings
2. Add lifecycle rules:
   - Delete objects after 30 days
   - Or transition to cheaper storage after 7 days

### 3. Set Reasonable Size Limits

```json
{
  "maxSize": 104857600  // 100MB limit prevents huge uploads
}
```

### 4. Monitor Usage

- Check R2 usage in Cloudflare dashboard
- Set up billing alerts for unexpected costs
- Monitor cache hit rates in your CI logs

### 5. Token Security

- Use read-only tokens for development environments
- Rotate API tokens regularly
- Use separate tokens for different environments
- Store tokens in secure secret management systems

## Troubleshooting

### Common Issues

**Authentication Errors:**
```
Error: Invalid credentials
```
- Verify your account ID and API token
- Ensure the token has `Cloudflare R2:Edit` permissions
- Check that the token hasn't expired

**Bucket Not Found:**
```
Error: NoSuchBucket
```
- Verify the bucket name is correct
- Ensure the bucket exists in the specified account
- Check bucket name spelling and case sensitivity

**Network Timeouts:**
```
Error: R2 fetch request timed out
```
- Check your network connection
- Verify Cloudflare R2 service status
- Consider if large files are causing timeouts

**Size Limit Exceeded:**
```
Output too large for R2 upload
```
- Increase `maxSize` limit if appropriate
- Review what files are being cached
- Consider excluding large build artifacts

### Debug Mode

Enable verbose logging to troubleshoot cache operations:

```bash
yarn lage build --verbose
```

This will show detailed information about cache hits, misses, and operations.

## Performance Considerations

### Cache Hit Optimization

- **Consistent hashing**: Ensure your build process is deterministic
- **Fine-grained caching**: Cache individual packages rather than entire monorepos
- **Smart invalidation**: Only invalidate cache when relevant files change

### Network Performance

- **Regional placement**: Choose R2 regions close to your CI infrastructure
- **Parallel uploads**: lage automatically handles concurrent operations
- **Compression**: Files are automatically tar-compressed before upload

### Cost Optimization

- **Lifecycle rules**: Set up automatic cleanup of old cache entries
- **Size limits**: Use `maxSize` to prevent unexpectedly large uploads
- **Read-only dev**: Use read-only tokens in development to avoid accidental uploads

## Comparison with Other Providers

| Feature | Cloudflare R2 | Azure Blob | AWS S3 |
|---------|---------------|------------|--------|
| Egress fees | ✅ Free | ❌ Charged | ❌ Charged |
| S3 compatibility | ✅ Yes | ❌ No | ✅ Native |
| Global CDN | ✅ Yes | ✅ Yes | ✅ Yes |
| Setup complexity | 🟡 Medium | 🟡 Medium | 🔴 Complex |
| Cost for CI/CD | 🟢 Low | 🟡 Medium | 🔴 High |

R2 is particularly cost-effective for CI/CD scenarios due to zero egress fees, making it ideal for frequent cache downloads during builds.