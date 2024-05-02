# -include .env 

# sdk.publish :; npm publish 

# sdk.build :; npm run build:types

# railway.link :; npx railway link  ${RAILWAY_PROJECT_ID} courageous-inspiration
# railway.service :; npx railway service courageous-inspiration
# railway.deploy :; npx railway up

push.glow :; git remote remove origin && \
			git remote add origin https://github.com/glowlabs-org/gca-crm-backend.git && \
			git push && \
			git remote remove origin && \
			git remote add origin https://github.com/0xSimbo/gca-crm-backend.git


