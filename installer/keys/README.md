# License / update public keys

Release builds embed the public key(s) here: they verify license keys and update packages signed
by MyWineCorks HQ. Public keys are safe to commit; **the private signing key never goes in the
repository** — it lives only in the production HQ secret store (`LICENSE_SIGNING_KEY`).

Create the production key pair once, before the first real release:

```bash
pnpm --filter @mwc/hq gen-signing-key ~/secure-folder
# → ~/secure-folder/license-signing.pem  (put in the secret store, then delete the file)
# → installer/keys/hq-license-public.pem (commit)
```
The Docker image and `installer/windows/build.sh --trust installer/keys/hq-license-public.pem`
then trust it. To rotate keys, add the new public key next to the old one (`--trust` takes several)
for one release before HQ switches to the new private key.
