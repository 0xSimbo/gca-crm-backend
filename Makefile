sdk.publish :; npm publish

sdk.build :; npm run build:types

push.glow :; git remote remove origin && \
			git remote add origin https://github.com/glowlabs-org/gca-crm-backend.git && \
			git push --set-upstream origin main && \
			git remote remove origin && \
			git remote add origin https://github.com/0xSimbo/gca-crm-backend.git