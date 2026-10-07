# London cost worksheet — 7 October 2026

DEV is deployed through Actions; actual inventory/status is in
[dev-deployment.md](dev-deployment.md). The retained state bucket is normally well
below $1/month for small state files/requests. Figures below estimate the approved
small DEV design, not a measured bill or spending cap. USD, 730 hours/month, on-demand, no
taxes, discounts, credits or free tiers assumed.

| Component and official rate | Dev/month | Prod/month |
| --- | ---: | ---: |
| ALB: $0.02646/hour | $19.32 | $19.32 |
| **Illustrative** continuously used 1 LCU: $0.0084/LCU-hour | $6.13 | $6.13 |
| Two ALB public IPv4 addresses: $0.005/IP-hour | $7.30 | $7.30 |
| Fargate Linux x86: $0.04656/vCPU-hour + $0.00511/GiB-hour; 0.25 CPU/0.5 GiB per task | $10.36, one task | $20.72, two tasks |
| RDS PostgreSQL: micro Single-AZ $0.018/hour; small Multi-AZ $0.072/hour | $13.14 | $52.56 |
| RDS gp3: $0.133/GB-month Single-AZ / $0.266 Multi-AZ; 20 / 50 provisioned | $2.66 | $13.30 |
| Four interface endpoints: $0.011/endpoint-AZ-hour; four / eight placements | $32.12 | $64.24 |
| Secrets Manager: $0.40/secret-month; four DEV (including disposable smoke fixture) / three prod | $1.60 | $1.20 |
| **Illustrative** average 10 GB retained ECR images: $0.10/GB-month | $1.00 | $1.00 |
| **Illustrative subtotal, not a ceiling or exact forecast** | **$93.63** | **$185.77** |

The actual one-task design's always-on subtotal is approximately **$86.50/month**
before LCU usage, image/object storage, requests, logs, alarms and transfer. Nine
explicit standard alarms plus two target-tracking alarms add approximately **$1.10/month**.
The table's $93.63 illustration additionally assumes one continuously used LCU and
10 GB retained ECR; it is not measured traffic. Use **$100–170/month** as the small
DEV planning envelope, not a hard cap. A second steady task would add $10.36/month;
the configured ceiling is two, and releases briefly overlap tasks.

The foundations incurred ALB/RDS/endpoint charges before task activation. Current
RDS is in `eu-west-2b`, whereas task/endpoints are in `eu-west-2a`, so database traffic
is cross-AZ and usage-dependent. No NAT, public task IP, WAF, CloudFront, Redis,
additional RDS or always-on job was added. Single-AZ placement is intentional; there
was no destructive relocation to improve the illustration.

Two extra continuous prod tasks add $20.72/month, giving an illustrative four-task
subtotal **$206.50**. Each additional sustained LCU adds $6.13/month. Task rolling
deployments temporarily run extra replicas. Right-sizing and credit usage must
be based on measured workloads.

## Endpoint versus NAT

| Egress design | Hourly infrastructure/month | Extra processing and trade-off |
| --- | ---: | --- |
| Four endpoints in one AZ | $32.12 | First endpoint-data tier $0.01/GB; one-AZ service dependency |
| Four endpoints in two AZs | $64.24 | $0.01/GB; supports required AWS APIs, not arbitrary internet |
| One zonal NAT | $36.50 | $0.05/GB plus public IPv4/transfer; AZ dependency, broad internet path |
| Two zonal NATs | $73.00 | $0.05/GB plus IPv4/transfer; per-AZ resilience |
| Regional NAT, one / two active AZs | $36.50 / $73.00 | Billed $0.05/hour **per active AZ**, plus $0.05/GB and applicable IPv4/transfer |

Regional NAT is available in London. One regional NAT identifier does not imply
one AZ's hourly bill when two AZs are active. Automatic AZ expansion can take up
to 60 minutes. NAT and endpoints are alternatives here: do not add both full costs
unless both are deliberately provisioned. The S3 gateway endpoint has no hourly
or processing charge. Cross-AZ traffic can add charges if paths cross AZs.

## Usage-dependent costs and uncertainty

- S3 images, **all retained versions**, requests and internet downloads; production-only ALB access logs (DEV access logging is disabled).
- CloudWatch Logs ingestion $0.5985/GB and retained storage $0.0315/GB-month;
  short retention does not limit how much is ingested each month.
- Standard CloudWatch alarm charges, SNS notifications and Secrets Manager API
  calls ($0.05/10,000); initial job credentials/API use is small, not free by assertion.
- RDS backup storage beyond included allocation and retained manual/final snapshots
  ($0.10/GB-month excess PostgreSQL backup), and burst credits
  ($0.075/vCPU-hour beyond baseline). Storage autoscaling also raises the bill.
- Endpoint bytes, inter-AZ/internet transfer, scaling ALB IP count, ECR storage
  growth, and rebuilds. Domain/DNS costs are outside this worksheet.

The earlier **$100–170/month dev / $220–380/month production** envelopes provide
unquantified headroom; they are not traffic-derived forecasts or guaranteed caps.
Confirm a notification recipient and measured burn-rate expectations before production.
An AWS Budget is advisory, not a technical hard spending cap; none has been created.

## Reproducible official sources

Prices came from AWS's public regional Price List JSON, publication dates
September 11–October 6, 2026. Representative SKUs: ALB `6AP766DZF74JPTE2`, LCU
`D4JRRS3AFPHRV7RF`, IPv4 `CB3E2ZKHCN8Y7SYP`, Fargate CPU/memory
`G265XVYY5YDS48U6` / `JPX9CCYJS97M953T`, RDS micro/small
`ATYF9R3XTURNBSMZ` / `Y7N82QD7P6BTUW9V`, endpoint `KHUBX8MMRC3RWAZY`.

- [ECS/Fargate regional prices](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonECS/current/eu-west-2/index.json)
- [ELB](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AWSELB/current/eu-west-2/index.json)
- [RDS](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonRDS/current/eu-west-2/index.json)
- [VPC/endpoints/IPv4](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonVPC/current/eu-west-2/index.json)
- [EC2/NAT](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonEC2/current/eu-west-2/index.json)
- [ECR](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonECR/current/eu-west-2/index.json)
- [Secrets Manager](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AWSSecretsManager/current/eu-west-2/index.json)
- [CloudWatch](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonCloudWatch/current/eu-west-2/index.json)
- [Regional NAT behavior](https://docs.aws.amazon.com/vpc/latest/userguide/nat-gateways-regional.html)
- [VPC billing](https://aws.amazon.com/vpc/pricing/)
