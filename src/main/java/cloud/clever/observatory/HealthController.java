package cloud.clever.observatory;

import java.util.Map;
import org.bson.Document;
import org.springframework.data.mongodb.core.MongoTemplate;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * /health answers without touching MongoDB (Clever Cloud's deployment health check).
 * /health/deep pings the add-on and counts the documents.
 */
@RestController
class HealthController {

    private final MongoTemplate mongo;

    HealthController(MongoTemplate mongo) {
        this.mongo = mongo;
    }

    @GetMapping("/health")
    Map<String, String> health() {
        return Map.of("status", "ok");
    }

    @GetMapping("/health/deep")
    ResponseEntity<Map<String, Object>> deep() {
        try {
            long start = System.nanoTime();
            mongo.getDb().runCommand(new Document("ping", 1));
            double pingMillis = Math.round((System.nanoTime() - start) / 10_000.0) / 100.0;
            String version = mongo.getDb().runCommand(new Document("buildInfo", 1)).getString("version");
            long documents = mongo.getCollection(SkyController.COLLECTION).estimatedDocumentCount();
            return ResponseEntity.ok(Map.of("status", "ok", "mongodb", Map.of(
                    "version", version, "pingMillis", pingMillis, "documents", documents)));
        } catch (RuntimeException e) {
            return ResponseEntity.status(HttpStatus.SERVICE_UNAVAILABLE)
                    .body(Map.of("status", "down", "mongodb", e.getClass().getSimpleName()));
        }
    }
}
