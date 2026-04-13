# TOOLS.md - API Reference

Your API keys are stored in `../.env` (chmod 600). Reference them as `$VAR_NAME` in shell commands.
**Never hardcode secrets.** Use env vars.

Check `CAPABILITIES.md` (auto-generated) for the full list of what's available.

---

## Add your services below

As you connect APIs, document them here so future-you knows the endpoints,
auth headers, and gotchas.

### Example format

```
## ServiceName
- **Base:** https://api.example.com/v1
- **Auth:** Bearer $SERVICE_API_KEY
- **Endpoints:** /users, /items, /orders
- **Notes:** Rate limited to 100 req/min. Use ?page= for pagination.
```
