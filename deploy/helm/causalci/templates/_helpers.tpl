{{- define "causalci.labels" -}}
app.kubernetes.io/name: causalci
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{- define "causalci.redisUrl" -}}
{{- if .Values.redis.enabled -}}redis://{{ .Release.Name }}-redis:6379{{- else -}}{{ required "redis.url is required when redis.enabled=false" .Values.redis.url }}{{- end -}}
{{- end }}

{{- define "causalci.restricted" -}}
runAsNonRoot: true
runAsUser: 1000
allowPrivilegeEscalation: false
readOnlyRootFilesystem: true
capabilities: { drop: ["ALL"] }
seccompProfile: { type: RuntimeDefault }
{{- end }}
