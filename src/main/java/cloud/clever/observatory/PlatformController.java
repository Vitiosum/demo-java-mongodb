package cloud.clever.observatory;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.bson.Document;
import org.springframework.boot.SpringBootVersion;
import org.springframework.data.mongodb.core.MongoTemplate;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

/** The "Running on Clever Cloud" panel. Only these platform variables are ever shown. */
@RestController
class PlatformController {

    private static final List<String> SHOWN = List.of(
            "CC_APP_NAME", "APP_ID", "INSTANCE_NUMBER", "INSTANCE_TYPE",
            "CC_PRETTY_INSTANCE_NAME", "CC_COMMIT_ID", "CC_DEPLOYMENT_ID");

    private final MongoTemplate mongo;

    PlatformController(MongoTemplate mongo) {
        this.mongo = mongo;
    }

    @GetMapping("/api/platform")
    Map<String, Object> platform() {
        Map<String, String> variables = new LinkedHashMap<>();
        for (String name : SHOWN) {
            String value = System.getenv(name);
            if (value != null && !value.isBlank()) {
                variables.put(name, name.equals("CC_COMMIT_ID") ? value.substring(0, Math.min(7, value.length())) : value);
            }
        }
        Map<String, Object> versions = new LinkedHashMap<>();
        versions.put("java", Runtime.version().feature());
        versions.put("springBoot", SpringBootVersion.getVersion());
        try {
            versions.put("mongodb", mongo.getDb().runCommand(new Document("buildInfo", 1)).getString("version"));
        } catch (RuntimeException e) {
            versions.put("mongodb", null);
        }
        return Map.of("variables", variables, "versions", versions);
    }
}
