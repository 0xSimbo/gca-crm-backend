sdk.publish :; npm publish

sdk.build :; npm run build:types

push.glow :; git remote remove origin && \
			git remote add origin https://github.com/glowlabs-org/gca-crm-backend.git && \
			git push --set-upstream origin main && \
			git remote remove origin && \
			git remote add origin https://github.com/0xSimbo/gca-crm-backend.git



gen.schema :; graphql get-schema --endpoint http://localhost:4000/graphql --output schema.graphql
apollo.schema :; apollo schema:download --endpoint=http://localhost:4000/graphql schema.graphql
manual.schema :; curl -X POST -H "Content-Type: application/json" --data '{ "query": "{ __schema { types { name fields { name description } } } }" }' http://localhost:4000/graphql > schema.json